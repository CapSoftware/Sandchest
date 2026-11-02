class UsersController < ApplicationController
  before_action :authenticate_user!

  def index
    @users = User.where("name LIKE '%#{params[:q]}%'")
  end

  def show
    @user = User.find(params[:id])
  end

  def export
    system("pg_dump #{params[:table]}")
  end

  private

  def user_params
    params.require(:user).permit(:name)
  end
end
