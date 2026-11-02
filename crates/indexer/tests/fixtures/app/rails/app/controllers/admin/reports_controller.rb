module Admin
  class ReportsController < ApplicationController
    def destroy
      redirect_to params[:return_to]
    end
  end
end
